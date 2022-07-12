import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

interface awsGroup {
    group: string,
    users: string[],
    policy: aws.iam.PolicyDocument,
    rolePolicies?: string[],
}

const config = new pulumi.Config();
const awsGroups = config.requireObject<awsGroup[]>("awsGroups");
// const prefix = `${pulumi.getProject()}-${pulumi.getStack()}`

awsGroups.map(g => {
    const group = new aws.iam.Group(g.group, {
        name: g.group,
    });
    const member = new aws.iam.GroupMembership(`${g.group}-member`, {
        group: group.name,
        users: g.users,
    })
    const policy = new aws.iam.GroupPolicy(`${g.group}-policy`, {
        group: group.name,
        namePrefix: "pulumi",
        policy: g.policy,
    })
    let counter = 0
    g.rolePolicies?.forEach(rp =>
        new aws.iam.GroupPolicyAttachment(`${g.group}}-attach-${counter++}`,
            {
                policyArn: rp,
                group: group.name,
            },
        )
    );
})






