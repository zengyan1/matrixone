import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";

// required configs
const config = new pulumi.Config();
const workers = config.requireObject<WorkerGroup[]>("workers")
const adminUsers = config.requireObject<string[]>("adminUsers");
const prefix = `${pulumi.getProject()}-${pulumi.getStack()}`

// optional knobs
const k8sVersion = config.get("k8sVersion") || "1.22";
const numberAZs = config.getNumber("numberAZs") || 3;
const adminRoles = config.getObject<string[]>("adminRoles") || [];

// account information
const current = aws.getCallerIdentity();
const accountId = current.then((c) => c.accountId);

interface WorkerGroup {
    name: string
    instanceType: string
    minSize: number
    maxSize: number
    amiId: string
    labels?: {
        [key: string]: string;
    }
    spotPrice?: string
}

const tags: aws.Tags = {
    [`kubernetes.io/cluster/${prefix}`]: "shared",
    "managed-by": "pulumi",
    "project": pulumi.getProject(),
    "stack": pulumi.getStack(),
}
const vpc = new awsx.ec2.Vpc(`${prefix}-vpc`, {
    numberOfAvailabilityZones: 3,
    cidrBlock: "10.0.0.0/16",
    subnets: [
        {
            type: "public",
            tags: {
                "kubernetes.io/role/internal-elb": "1",
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

const k8s = allSubnets.then(subNets =>
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
        enabledClusterLogTypes: ["api", "authenticator", "scheduler", "controllerManager", "audit"],
        tags: tags,
    })
)

k8s.then(v => workers.map(worker =>
    v.createNodeGroup(`${prefix}-${worker.name}`, {
        instanceType: worker.instanceType,
        nodeAssociatePublicIpAddress: false,
        version: k8sVersion,
        amiId: worker.amiId,
        labels: worker.labels,
        spotPrice: worker.spotPrice,
        minSize: worker.minSize,
        maxSize: worker.maxSize,
        autoScalingGroupTags: {
            "k8s.io/cluster-autoscaler/workload": `${prefix}-${worker.name}`,
            ...tags,
        },
        cloudFormationTags: {
            "CloudFormationGroupTag": "true",
            "k8s.io/cluster-autoscaler/enabled": "true",
        },
        instanceProfile: new aws.iam.InstanceProfile(`${prefix}-${worker.name}`, { role: "EKSWorkerNodeRole" })
    })
))

// utilities
function createUserMappings(users: string[]): eks.UserMapping[] {
    const mappings: eks.UserMapping[] = [];
    for (const user of users) {
        const mapping: eks.UserMapping = {
            groups: ["system:masters"],
            userArn: pulumi.interpolate`arn:aws:iam::${accountId}:user/${user}`,
            username: user,
        };
        mappings.push(mapping);
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