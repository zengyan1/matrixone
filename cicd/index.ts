import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();
const githubToken = config.requireSecret("githubToken");
// TODO: enable if we need to attach existing policy
// const roles = config.requireObject<string[]>("roles");
const arcVersion = config.get("arcVersion") || "0.20.1"
const certManagerVersion = config.get("certManagerVersion") || "v1.8.2"
const prefix = `${pulumi.getProject()}-${pulumi.getStack()}`
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
    ],
}

// cluster information from EKS stack
const baseEKS = new pulumi.StackReference(config.require("eks"));
const baseEKSProvider = new k8s.Provider("base", {
    kubeconfig: baseEKS.requireOutput("kubeconfig"),
});
const accountId = baseEKS.requireOutput("accountId");
const oidcProvider = baseEKS.requireOutput("oidcProvider");

// basic
const ns = new k8s.core.v1.Namespace("ns", {
    metadata: {
        name: "cicd",
    },
}, { provider: baseEKSProvider });

const certManager = new k8s.helm.v3.Chart("cert", {
    chart: "cert-manager",
    version: certManagerVersion,
    namespace: ns.metadata.name,
    values: {
        installCRDs: true,
    },
    fetchOpts: {
        repo: "https://charts.jetstack.io",
    },
}, { provider: baseEKSProvider })

const tokenSecret = new k8s.core.v1.Secret("github-runner", {
    metadata: {
        namespace: ns.metadata.name,
        name: "controller-manager",
    },
    stringData: {
        "github_token": githubToken,
    },
}, { provider: baseEKSProvider });

const arc = new k8s.helm.v3.Chart("arc", {
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
}, { provider: baseEKSProvider, dependsOn: [certManager] });

// create k8s serviceaccount => AWS role mapping
const roleName = `${prefix}-role`;
const sa = new k8s.core.v1.ServiceAccount("sa", {
    metadata: {
        annotations: {
            "eks.amazonaws.com/role-arn": pulumi.interpolate`arn:aws:iam::${accountId}:role/${roleName}`,
        },
        name: "cicd",
        namespace: ns.metadata.name,
    },
}, { provider: baseEKSProvider });
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
                        StringLike: { [`${v}:sub`]: pulumi.interpolate`system:serviceaccount:${ns.metadata.name}:cicd` },
                    },
                },
            ],
        },
    })
    // set inline policy
    new aws.iam.RolePolicy(`${prefix}-policy`, {
        role: pulumi.interpolate`${r.id}`,
        policy: inlinePolicy,
    })
    // TODO(aylei): possibly bind policy attachment
    // let counter = 0;
    // for (const rp of roles) {
    //     // Create RolePolicyAttachment without returning it.
    //     new aws.iam.RolePolicyAttachment(`${prefix}-policy-${counter++}`,
    //         { policyArn: rp, role: r },
    //     );
    // }
})

// deploy github runners
const armRunner = new k8s.apiextensions.CustomResource("arm-runner", {
    apiVersion: "actions.summerwind.dev/v1alpha1",
    kind: "RunnerDeployment",
    metadata: {
        name: "arm64-runner",
        namespace: ns.metadata.name,
    },
    spec: {
        template: {
            spec: {
                // TODO: change to org level runner once we use a token with org-level permission
                // organization: "matrixorigin",
                repository: "matrixorigin/ops",
                labels: ["arm64-runner"],
                serviceAccountName: sa.metadata.name,
                nodeSelector: {
                    "beta.kubernetes.io/arch": "arm64",
                },
                // TODO: customize more fields, ref: https://github.com/actions-runner-controller/actions-runner-controller#additional-tweaks
                // image: 
                // resources:
                // sidecar
            },
        },
    },
}, { provider: baseEKSProvider, dependsOn: [arc, sa] })
const armRunnerScaling = new k8s.apiextensions.CustomResource("arm-runner", {
    apiVersion: "actions.summerwind.dev/v1alpha1",
    kind: "HorizontalRunnerAutoscaler",
    metadata: {
        name: "github-runner-arm64",
        namespace: ns.metadata.name,
    },
    spec: {
        minReplicas: 0,
        maxReplicas: 10,
        scaleTargetRef: {
            name: armRunner.metadata.name,
        },
        scaleUpTriggers: [{
            githubEvent: {
                checkRun: {
                    types: ["created"],
                    status: "queued"
                }
            },
            amount: 1,
            duration: "5m",
        }],
    },
}, { provider: baseEKSProvider, dependsOn: [arc, sa] })
