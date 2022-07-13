# CICD

CICD manages self-hosted CICD environment for github action (aka self-hosted github runner).

## Add Runner

To add a new kind of runner, you need to declare a `RunnerDeployment` spec,
plus a `HorizontalRunnerAutoscaler` spec to manage the runner replicas.

Example can be found [here](https://github.com/matrixorigin/ops/blob/13841305c13ca98dff1cdacdfae6fe216e7d59bc/cicd/index.ts#L163).

Note that the `labels` of each kind of runner is exactly what we will use in github action's `runs-on: ${label}` primitive.

## Add Repo / Org

When you add a runner, you also declare what repo/org it serves, e.g.

```yaml
spec:
  template:
    spec:
      # repository: "matrixorigin/ops"
      organization: "matrixorigin"
```

Note that the runner controller need admin permission to [configure self-hosted runner](https://docs.github.com/en/actions/hosting-your-own-runners/adding-self-hosted-runners) for the target repo/org, which means the github token configured in [pulumi config](./Pulumi.aws.yaml) must have admin permissions.

## Add Webhook

When we use webhook-based runner autoscaling policy (which is recommended and is currently used), each repository that will use the self-hosted runner should configure a webhook.

Events will be sent to runner controller via the webhook to trigger the scale-out of runners.

Steps of adding the webhook:

1. Go to the settings page of repository or organization then click on Webhooks, then on Add webhook;
2. Set `Payload URL` to `http://ab911e746904641bf9b192d1b4ee17b6-1421728108.us-west-2.elb.amazonaws.com/actions-runner-controller-github-webhook-server`, with `application/json` content type;
3. Choose the following events to send:
    - Check runs
    - Pushes
    - Pull Requests

## Reference

Refer to [index.ts](./index.ts) for the whole environment setup and refer to [the official documentation of action runner controller](https://github.com/actions-runner-controller/actions-runner-controller/blob/master/README.md) for more configuration details of `RunnerDeployment`.