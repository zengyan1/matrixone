import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

interface UserMapping {
  group: string;
  users: string[];
}

// required configs
const config = new pulumi.Config();
const workers = config.requireObject<WorkerGroup[]>("workers");
const adminUsers = config.requireObject<UserMapping[]>("userMappings");
const prefix = `${pulumi.getProject()}-${pulumi.getStack()}`;

// optional knobs
const k8sVersion = config.get("k8sVersion") || "1.22";
const adminRoles = config.getObject<string[]>("adminRoles") || [];

// account information
const current = aws.getCallerIdentity();
export const accountId = current.then((c) => c.accountId);

interface WorkerGroup {
  name: string;
  instanceType: string;
  minSize: number;
  maxSize: number;
  amiId: string;
  labels: {
    [key: string]: string;
  };
  spotPrice?: string;
  azs: number;
  rootVolumeSize?: number;
}

const tags: aws.Tags = {
  [`kubernetes.io/cluster/${prefix}`]: "shared",
  "managed-by": "pulumi",
  project: pulumi.getProject(),
  stack: pulumi.getStack(),
};
const vpc = new awsx.ec2.Vpc(`${prefix}-vpc`, {
  numberOfAvailabilityZones: 3,
  cidrBlock: "10.0.0.0/16",
  subnets: [
    {
      type: "public",
      tags: {
        "kubernetes.io/role/elb": "1",
        ...tags,
      },
    },
    {
      type: "private",
      tags: {
        "kubernetes.io/role/internal-elb": "1",
        ...tags,
      },
    },
  ],
  tags: tags,
});
const allSubnets = Promise.all([
  vpc.privateSubnetIds,
  vpc.publicSubnetIds,
]).then(([privateIds, publicIds]) => {
  return privateIds.concat(publicIds);
});

const k8sCluster = allSubnets.then(
  (subNets) =>
    new eks.Cluster(`${prefix}-eks`, {
      name: prefix,
      skipDefaultNodeGroup: true,
      vpcId: vpc.id,
      endpointPrivateAccess: true,
      endpointPublicAccess: true,
      nodeAssociatePublicIpAddress: false,
      createOidcProvider: true,
      subnetIds: subNets,
      version: k8sVersion,
      userMappings: createUserMappings(adminUsers),
      roleMappings: createRoleMappings(adminRoles),
      instanceRole: nodeRole,
      enabledClusterLogTypes: [
        "api",
        "authenticator",
        "scheduler",
        "controllerManager",
        "audit",
      ],
      tags: tags,
    })
);

const nodeRole = createRole(`${prefix}-node-role`, [
  "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
  "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
  "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
]);

const nodeProfile = new aws.iam.InstanceProfile(`${prefix}-node-profile`, {
  role: nodeRole,
});

k8sCluster.then((v) => {
  workers.map((worker) => {
    const nodeLabels: aws.Tags = {};
    for (const [lk, lv] of Object.entries(worker.labels)) {
      nodeLabels[`k8s.io/cluster-autoscaler/node-template/label/${lk}`] = lv;
    }
    v.createNodeGroup(`${prefix}-${worker.name}`, {
      instanceType: worker.instanceType,
      nodeAssociatePublicIpAddress: false,
      nodeSubnetIds: vpc.privateSubnetIds.then(ids => ids.slice(0, worker.azs)),
      version: k8sVersion,
      amiId: worker.amiId,
      labels: worker.labels,
      spotPrice: worker.spotPrice,
      minSize: worker.minSize,
      maxSize: worker.maxSize,
      nodeRootVolumeSize: worker.rootVolumeSize || 20,
      autoScalingGroupTags: {
        "k8s.io/cluster-autoscaler/workload": `${prefix}-${worker.name}`,
        ...tags,
        CloudFormationGroupTag: "true",
        [`k8s.io/cluster-autoscaler/${prefix}`]: "owned",
        "k8s.io/cluster-autoscaler/enabled": "true",
        ...nodeLabels,
      },
      instanceProfile: nodeProfile,
    });
  });

  const clusterAutoScalerSaName = "cluster-autoscaler";
  const albSaAssumeRolePolicy = pulumi
    .all([v.core.oidcProvider!.url, v.core.oidcProvider?.arn])
    .apply(([url, arn]) =>
      aws.iam.getPolicyDocument({
        statements: [
          {
            actions: ["sts:AssumeRoleWithWebIdentity"],
            conditions: [
              {
                test: "StringEquals",
                values: [
                  `system:serviceaccount:kube-system:${clusterAutoScalerSaName}`,
                ],
                variable: `${url.replace("https://", "")}:sub`,
              },
            ],
            effect: "Allow",
            principals: [
              {
                identifiers: [arn],
                type: "Federated",
              },
            ],
          },
        ],
      })
    );

  const clusterAutoScalerRole = new aws.iam.Role(`${prefix}-scaler`, {
    assumeRolePolicy: albSaAssumeRolePolicy.json,
  });

  new aws.iam.RolePolicy(`${prefix}-scaler`, {
    namePrefix: `${prefix}-scaler`,
    role: clusterAutoScalerRole,
    policy: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "autoscaling:DescribeAutoScalingGroups",
            "autoscaling:DescribeAutoScalingInstances",
            "autoscaling:DescribeLaunchConfigurations",
            "autoscaling:DescribeTags",
            "autoscaling:SetDesiredCapacity",
            "autoscaling:TerminateInstanceInAutoScalingGroup",
            "ec2:DescribeLaunchTemplateVersions",
          ],
          Resource: "*",
        },
      ],
    },
  });

  const clusterAutoScalerSa = new k8s.core.v1.ServiceAccount(
    clusterAutoScalerSaName,
    {
      metadata: {
        namespace: "kube-system",
        name: clusterAutoScalerSaName,
        annotations: {
          "eks.amazonaws.com/role-arn": clusterAutoScalerRole.arn,
        },
      },
    },
    { provider: v.provider }
  );

  new k8s.helm.v3.Chart(
    "cluster-auto-scaler",
    {
      namespace: "kube-system",
      values: {
        clusterName: pulumi.interpolate`${v.eksCluster.name}`,
      },
      path: "./aws-cluster-auto-scaler",
    },
    { provider: v.provider, dependsOn: [clusterAutoScalerSa] }
  );

  const csiSA = "ebs-csi-controller-sa";
  const csiRole = new aws.iam.Role(`${prefix}-csi-driver`, {
    namePrefix: `${prefix}-csi-drvier`,
    managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"],
    assumeRolePolicy: pulumi.interpolate`{
      "Version": "2012-10-17",
      "Statement": [{
        "Action": "sts:AssumeRoleWithWebIdentity",
        "Principal": {
          "Federated": "arn:aws:iam::${accountId}:oidc-provider/${v.core.oidcProvider!.url}"
        },
        "Effect": "Allow",
        "Condition": {
          "StringLike": {
            "${v.core.oidcProvider!.url}:sub": "system:serviceaccount:*:${csiSA}"
          }
        }
      }]
    }`,
  });

  const csiDriver = new aws.eks.Addon("csi", {
    addonName: "aws-ebs-csi-driver",
    clusterName: v.eksCluster.name,
    serviceAccountRoleArn: csiRole.arn,
  });

  const gp3Sc = new k8s.storage.v1.StorageClass("gp3", {
    metadata: {
      name: "gp3",
    },
    parameters: {
      type: "gp3",
    },
    provisioner: "ebs.csi.aws.com",
    reclaimPolicy: "Delete",
    allowVolumeExpansion: true,
    volumeBindingMode: "WaitForFirstConsumer",
    mountOptions: ["nodelalloc", "noatime"],
  }, {provider: v.provider});

  const developerRole = new k8s.rbac.v1.ClusterRole("developer-role", {
    metadata: {
      name: "developer",
    },
    rules: [{
      apiGroups: [""],
      resources: [
          "pods",
          "services",
          "configmaps",
          "secrets",
          "persistentvolumeclaims",
          "endpoints",
          "events",
          "namespaces",
          "serviceaccounts",
          "pods/log",
          "pods/exec",
      ],
      verbs: ["*"],
    }, {
      apiGroups: ["apps"],
      resources: [
          "deployments",
          "jobs",
          "cronjobs",
          "daemonsets",
      ],
      verbs: ["*"],
    }, {
      apiGroups: ["apps.kruise.io"],
      resources: [
          "statefulsets",
          "statefulsets/status",
      ],
      verbs: ["*"],
    }, {
      apiGroups: ["core.matrixorigin.io"],
      resources: [
          "matrixoneclusters",
          "matrixoneclusters/status",
          "logsets",
          "logsets/status",
          "cnsets",
          "cnsets/status",
          "dnsets",
          "dnsets/status",
          "webuis",
          "webuis/status"
      ],
      verbs: ["*"],
    }],
  }, {provider: v.provider});

  const developerRoleBinding = new k8s.rbac.v1.ClusterRoleBinding("developer-role", {
    metadata: {
      name: "developer",
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "developer",
    },
    subjects: [{
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Group",
      name: "system:developer",
    }]
  }, {provider: v.provider});
});

export const oidcProvider = k8sCluster.then((v) => v.core.oidcProvider!.url);
// export kubeconfig is safe even if the pulumi credential is compromised since the
// EKS kubeconfig requires user's AWS credential of perform AuthN & AuthZ
export const kubeconfig = k8sCluster.then((v) =>
  v.kubeconfig.apply(JSON.stringify)
);

// utilities
function createUserMappings(ms: UserMapping[]): eks.UserMapping[] {
  const mappings: eks.UserMapping[] = [];
  for (const m of ms) {
    for (const u of m.users) {
      const mapping: eks.UserMapping = {
        groups: [m.group],
        userArn: pulumi.interpolate`arn:aws:iam::${accountId}:user/${u}`,
        username: u,
      };
      mappings.push(mapping);
    }
  }
  return mappings;
}

function createRoleMappings(roles: string[]): eks.RoleMapping[] {
  const mappings: eks.RoleMapping[] = [];
  for (const role of roles) {
    const mapping: eks.RoleMapping = {
      groups: ["system:masters"],
      roleArn: pulumi.interpolate`arn:aws:iam::${accountId}:role/${role}`,
      username: role,
    };
    mappings.push(mapping);
  }
  return mappings;
}

function createRole(name: string, policies: string[]): aws.iam.Role {
  const role = new aws.iam.Role(name, {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: "ec2.amazonaws.com",
    }),
  });

  let counter = 0;
  for (const policy of policies) {
    // Create RolePolicyAttachment without returning it.
    const rpa = new aws.iam.RolePolicyAttachment(
      `${name}-policy-${counter++}`,
      { policyArn: policy, role: role }
    );
  }

  return role;
}
