import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

interface Runner {
    name: string;
    labels: string[];
    minReplicas: number;
    maxReplicas: number;
    duration: string;
    nodeSelector: {
        [key: string]: string;
    };
    resources?: {
        limits: {
            cpu: string;
            memory: string;
        };
        requests: {
            cpu: string;
            memory: string;
        };
    };
}

const config = new pulumi.Config();
const githubToken = config.requireSecret("githubToken");
// TODO: enable if we need to attach existing policy
// const roles = config.requireObject<string[]>("roles");
const arcVersion = config.get("arcVersion") || "0.20.2";
const certManagerVersion = config.get("certManagerVersion") || "v1.8.2";
const prefix = `${pulumi.getProject()}-${pulumi.getStack()}`;

const inlinePolicy: aws.iam.PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["iam:*"],
      Effect: "Allow",
      Resource: "*",
    },
    {
      Action: ["ec2:*"],
      Effect: "Allow",
      Resource: "*",
    },
    {
      Action: ["elasticloadbalancing:*"],
      Effect: "Allow",
      Resource: "*",
    },
    {
      Action: ["route53:*"],
      Effect: "Allow",
      Resource: "*",
    },
    {
      Action: ["s3:*"],
      Effect: "Allow",
      Resource: "*",
    },
    {
      Action: ["eks:*"],
      Effect: "Allow",
      Resource: "*",
    },
    {
      Action: ["ecr:*"],
      Effect: "Allow",
      Resource: "*",
    },
    {
      Action: ["sts:*"],
      Effect: "Allow",
      Resource: "*",
    },
    {
      Action: ["ssm:*"],
      Effect: "Allow",
      Resource: "*",
    },
    {
      Action: ["autoscaling:*"],
      Effect: "Allow",
      Resource: "*",
    },
    {
      Action: ["cloudformation:*"],
      Effect: "Allow",
      Resource: "*",
    },
  ],
};

// cluster information from EKS stack
const baseEKS = new pulumi.StackReference(config.require("eks"));
const baseEKSProvider = new k8s.Provider("base", {
  kubeconfig: baseEKS.requireOutput("kubeconfig"),
});
const accountId = baseEKS.requireOutput("accountId");
const oidcProvider = baseEKS.requireOutput("oidcProvider");

// basic
const ns = new k8s.core.v1.Namespace(
  "ns",
  {
    metadata: {
      name: "cicd",
    },
  },
  { provider: baseEKSProvider }
);

const certManager = new k8s.helm.v3.Chart(
  "cert",
  {
    chart: "cert-manager",
    version: certManagerVersion,
    namespace: ns.metadata.name,
    values: {
      installCRDs: true,
    },
    fetchOpts: {
      repo: "https://charts.jetstack.io",
    },
  },
  { provider: baseEKSProvider }
);

const tokenSecret = new k8s.core.v1.Secret(
  "github-runner",
  {
    metadata: {
      namespace: ns.metadata.name,
      name: "controller-manager",
    },
    stringData: {
      github_token: githubToken,
    },
  },
  { provider: baseEKSProvider }
);

const arc = new k8s.helm.v3.Chart(
  "arc",
  {
    chart: "actions-runner-controller",
    version: arcVersion,
    namespace: ns.metadata.name,
    values: {
      githubWebhookServer: {
        enabled: true,
        service: {
          type: "LoadBalancer",
        },
      },
    },
    fetchOpts: {
      repo: "https://actions-runner-controller.github.io/actions-runner-controller",
    },
  },
  { provider: baseEKSProvider, dependsOn: [certManager] }
);

// create k8s serviceaccount => AWS role mapping
const roleName = `${prefix}-role`;
const sa = new k8s.core.v1.ServiceAccount(
  "sa",
  {
    metadata: {
      annotations: {
        "eks.amazonaws.com/role-arn": pulumi.interpolate`arn:aws:iam::${accountId}:role/${roleName}`,
      },
      name: "cicd",
      namespace: ns.metadata.name,
    },
  },
  { provider: baseEKSProvider }
);
const role = pulumi.all([accountId, oidcProvider]).apply(([id, v]) => {
  const r = new aws.iam.Role("role", {
    name: `${prefix}-role`,
    assumeRolePolicy: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "sts:AssumeRoleWithWebIdentity",
          Principal: {
            Federated: `arn:aws:iam::${id}:oidc-provider/${v}`,
          },
          Effect: "Allow",
          Condition: {
            StringLike: {
              [`${v}:sub`]: pulumi.interpolate`system:serviceaccount:${ns.metadata.name}:cicd`,
            },
          },
        },
      ],
    },
  });
  // set inline policy
  new aws.iam.RolePolicy(`${prefix}-policy`, {
    role: pulumi.interpolate`${r.id}`,
    policy: inlinePolicy,
  });
  // TODO(aylei): possibly bind policy attachment
  // let counter = 0;
  // for (const rp of roles) {
  //     // Create RolePolicyAttachment without returning it.
  //     new aws.iam.RolePolicyAttachment(`${prefix}-policy-${counter++}`,
  //         { policyArn: rp, role: r },
  //     );
  // }
});

// deploy github runners
const armRunner = new k8s.apiextensions.CustomResource(
  "arm-runner",
  {
    apiVersion: "actions.summerwind.dev/v1alpha1",
    kind: "RunnerDeployment",
    metadata: {
      name: "arm64-runner",
      namespace: ns.metadata.name,
    },
    spec: {
      template: {
        spec: {
          organization: "matrixorigin",
          labels: ["arm64-runner", "eks"],
          serviceAccountName: sa.metadata.name,
          nodeSelector: {
            "beta.kubernetes.io/arch": "arm64",
          },
          image: "468413122983.dkr.ecr.us-west-2.amazonaws.com/actions-runner:dind-multiarch",
          imagePullPolicy: "IfNotPresent",
          dockerdWithinRunnerContainer: true,
          resources: {
            limits: {
              cpu: "4.0",
              memory: "14Gi",
            },
            requests: {
              cpu: "2.0",
              memory: "8Gi",
            },
          },
          // sidecar
        },
      },
    },
  },
  { provider: baseEKSProvider, dependsOn: [arc, sa] }
);
const armRunnerScaling = new k8s.apiextensions.CustomResource(
  "arm-runner",
  {
    apiVersion: "actions.summerwind.dev/v1alpha1",
    kind: "HorizontalRunnerAutoscaler",
    metadata: {
      name: "github-runner-arm64",
      namespace: ns.metadata.name,
    },
    spec: {
      // keep at least 1 runner for avoid forever starving
      minReplicas: 1,
      maxReplicas: 20,
      scaleTargetRef: {
        name: armRunner.metadata.name,
      },
      scaleUpTriggers: [
        {
          githubEvent: {
            workflowJob: {},
          },
          amount: 1,
          // duration is the lease time of the compute resource requested by each workflow job,
          // which means that the corresponding runner will run continuously for at least the lease time
          duration: "30m",
        },
      ],
    },
  },
  { provider: baseEKSProvider, dependsOn: [arc, sa] }
);

const x86runner = new k8s.apiextensions.CustomResource(
    "x86-runner",
    {
        apiVersion: "actions.summerwind.dev/v1alpha1",
        kind: "RunnerDeployment",
        metadata: {
            name: "x86-runner",
            namespace: ns.metadata.name,
        },
        spec: {
            template: {
                spec: {
                    organization: "matrixorigin",
                    labels: ["x86-runner", "eks"],
                    serviceAccountName: sa.metadata.name,
                    nodeSelector: {
                        "beta.kubernetes.io/arch": "amd64",
                    },
                    image: "468413122983.dkr.ecr.us-west-2.amazonaws.com/actions-runner:dind-multiarch",
                    imagePullPolicy: "IfNotPresent",
                    dockerdWithinRunnerContainer: true,
                    resources: {
                        limits: {
                            cpu: "8.0",
                            memory: "14Gi",
                        },
                        requests: {
                            cpu: "4.0",
                            memory: "8Gi",
                        },
                    },
                },
            },
        },
    },
    { provider: baseEKSProvider, dependsOn: [arc, sa] }
);
const x86RunnerScaling = new k8s.apiextensions.CustomResource(
    "x86-runner",
    {
        apiVersion: "actions.summerwind.dev/v1alpha1",
        kind: "HorizontalRunnerAutoscaler",
        metadata: {
            name: "github-runner-x86",
            namespace: ns.metadata.name,
        },
        spec: {
            // keep at least 1 runner for avoid forever starving
            minReplicas: 1,
            maxReplicas: 20,
            scaleTargetRef: {
                name: x86runner.metadata.name,
            },
            scaleUpTriggers: [
                {
                    githubEvent: {
                        workflowJob: {},
                    },
                    amount: 1,
                    // duration is the lease time of the compute resource requested by each workflow job,
                    // which means that the corresponding runner will run continuously for at least the lease time
                    duration: "60m",
                },
            ],
        },
    },
    { provider: baseEKSProvider, dependsOn: [arc, sa] }
);

// mo-cloud runners
const moCloudRunner = new k8s.apiextensions.CustomResource(
    "mocloud-arm-runner",
    {
        apiVersion: "actions.summerwind.dev/v1alpha1",
        kind: "RunnerDeployment",
        metadata: {
            name: "mocloud-arm-runner",
            namespace: ns.metadata.name,
        },
        spec: {
            template: {
                spec: {
                    organization: "matrixone-cloud",
                    labels: ["arm64-runner", "eks"],
                    serviceAccountName: sa.metadata.name,
                    nodeSelector: {
                        "beta.kubernetes.io/arch": "arm64",
                    },
                    image: "468413122983.dkr.ecr.us-west-2.amazonaws.com/actions-runner:dind-multiarch",
                    imagePullPolicy: "IfNotPresent",
                    dockerdWithinRunnerContainer: true,
                    resources: {
                        limits: {
                            cpu: "4.0",
                            memory: "14Gi",
                        },
                        requests: {
                            cpu: "1.0",
                            memory: "8Gi",
                        },
                    },
                },
            },
        },
    },
    { provider: baseEKSProvider, dependsOn: [arc, sa] }
);
const moCloudRunnerScaling = new k8s.apiextensions.CustomResource(
    "mocloud-arm-runner-scaling",
    {
        apiVersion: "actions.summerwind.dev/v1alpha1",
        kind: "HorizontalRunnerAutoscaler",
        metadata: {
            name: "mocloud-arm-runner-scaling",
            namespace: ns.metadata.name,
        },
        spec: {
            minReplicas: 1,
            maxReplicas: 10,
            scaleTargetRef: {
                name: moCloudRunner.metadata.name,
            },
            scaleUpTriggers: [
                {
                    githubEvent: {
                        workflowJob: {},
                    },
                    amount: 1,
                    // duration is the lease time of the compute resource requested by each workflow job,
                    // which means that the corresponding runner will run continuously for at least the lease time
                    duration: "30m",
                },
            ],
        },
    },
    { provider: baseEKSProvider, dependsOn: [arc, sa] }
);
