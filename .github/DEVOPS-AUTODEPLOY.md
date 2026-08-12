# Auto-deploy executive-report.spyne.ai on every change

Goal: every push to **`aws-prod`** should rebuild the container and roll the ECS
service automatically, so `https://executive-report.spyne.ai` always reflects
the latest code. Today it only refreshes when the pipeline is run by hand.

Pick **ONE** of the two options below — not both (or every push builds twice).

---

## Option A — Enable the native CodePipeline trigger (recommended, least work)

The pipeline that already serves this app builds from `aws-prod` using the
repo's `code-build.yaml` / `code-deploy.yaml`. It just isn't auto-starting on
push. Turn that on:

- If the source is a **CodeStar / GitHub (v2) connection**: edit the pipeline's
  Source stage and enable **"Start the pipeline on source code change"** (this
  creates the webhook). 
- If the source is **GitHub (v1) / OAuth**: ensure the webhook exists
  (`aws codepipeline register-webhook-with-third-party`), or toggle
  `PollForSourceChanges` on the source action.

Nothing in this repo needs to change. After this, a push to `aws-prod`
auto-builds and deploys. Delete `.github/workflows/aws-deploy.yml` if you go
this route, to avoid double-builds.

---

## Option B — Activate the GitHub Actions workflow (repo-owned)

`.github/workflows/aws-deploy.yml` already does: build → push to ECR → force an
ECS rollout, on every push to `aws-prod`. It is **dormant** until the items
below exist. It uses **OIDC** (no long-lived AWS keys stored in GitHub).

### 1. Create an IAM role for GitHub OIDC
Trust policy (restrict to this repo + the `aws-prod` branch):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:spyne-ai-agentic-dev/Executive-Report:ref:refs/heads/aws-prod" }
    }
  }]
}
```
(If the GitHub OIDC provider doesn't exist yet in the account, create it once:
provider URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.)

Permissions the role needs (scope the resources to this app's ECR repo / ECS
service where possible):

```
ecr:GetAuthorizationToken            (resource: *)
ecr:BatchCheckLayerAvailability
ecr:InitiateLayerUpload
ecr:UploadLayerPart
ecr:CompleteLayerUpload
ecr:PutImage
ecr:BatchGetImage
ecs:UpdateService
ecs:DescribeServices
```

### 2. Set repo **Variables** (Settings → Secrets and variables → Actions → Variables)
| Variable | Example | Meaning |
|---|---|---|
| `AWS_DEPLOY_ENABLED` | `true` | Master switch — the job is skipped until this is `true`. |
| `AWS_REGION` | `ap-south-1` | Region of the ECR repo + ECS service. |
| `ECR_REPOSITORY` | `executive-report` | ECR repo name (the pipeline's `IMAGE_REPO_NAME`). |
| `ECS_CLUSTER` | `spyne-...` | ECS cluster name. |
| `ECS_SERVICE` | `executive-report` | ECS service name. |

### 3. Set repo **Secret**
| Secret | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | ARN of the role from step 1 |

### 4. Task-definition note
The workflow pushes `:latest` and force-new-deployments the service. That only
picks up the new image if the **task definition references the `:latest` tag**.
If it pins a specific tag instead, tell me and I'll switch the workflow to
register a new task-def revision with the commit tag (needs `ecs:RegisterTaskDefinition`
and `iam:PassRole` on the task/execution roles).

Once 1–3 are in place, push to `aws-prod` (or run the workflow manually) →
executive-report.spyne.ai refreshes automatically.
