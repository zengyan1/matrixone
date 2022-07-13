# ops

Confidently operate our production via git

## Process

1. clone this repository;
2. checkout your local development branch;
3. make some changes as you like;
4. run `make reviewable` before you open an PR;
5. file an pull request and check the pulumi preview;
6. get someone with write access approving your PR;
7. merge the pull request and your change will be applied to the target environment shortly.

## Projects and Stacks

Refer to [Projects and Stacks](https://www.pulumi.com/docs/intro/pulumi-service/projects-and-stacks/) for the explanations of `Project` and `Stack`, here are the projects and stacks this repo manages:

- [eks](./eks): manage EKS clusters, each stack is corresponding to an EKS cluster, well-known stacks:
  - [eks/ci](./eks/Pulumi.ci.yaml): the EKS cluster for CICD;
- [cicd](./cicd): manage CICD environments, each stack is corresponding to an CI environment, well-known stacks:
  - [cicd/aws](./cicd/Pulumi.aws.yaml): the default CI environment on AWS;
- [iam](./iam): manage IAM policies in different environment, each stack is corresponding to a target environment, well-known stacks:
  - [iam/dev](./iam/Pulumi.dev.yaml): manage the IAM policies in dev environment;

## Access Clusters

1. Make sure you have added yourself to the `adminUsers` (maybe we need more groups later with fine-grained permissions) of the target cluster, e.g. [eks/ci](./eks/Pulumi.ci.yaml);
2. Find the cluster via `aws eks list-clusters --region ${region}`, you can find the region in the pulumi config of the target cluster, e.g. [eks/ci](./eks/Pulumi.ci.yaml);
3. Save the kubeconfig via `aws eks --region ${region} update-kubeconfig --name ${cluster-name} --kubeconfig ${file}`;
4. `export KUBECONFIG=$PWD/${file}` and you are good to go.

## Index

- [Configure CICD environment (self-hosted github runner)](./cicd/README.md)
