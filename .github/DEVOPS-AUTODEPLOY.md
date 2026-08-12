# Auto-deploy executive-report.spyne.ai

**Status: fully automatic. No manual step, no DevOps action needed.**

How a code change reaches the live AWS site (ECS Fargate):

1. Commit lands on **`main`**.
2. **`.github/workflows/aws-promote.yml`** fires on that push and fast-forwards
   **`aws-prod` → `main`** (fast-forward only; it fails loudly if `aws-prod` ever
   diverged, rather than force-pushing).
3. AWS **CodePipeline auto-triggers on the `aws-prod` push** (this is already
   enabled — verified: a push rebuilt the image on its own), runs
   `code-build.yaml` (build → ECR) then `code-deploy.yaml`, and rolls the ECS
   service. Takes ~5-8 min.
4. `https://executive-report.spyne.ai` serves the new image.

So: **just push to `main`** — everything downstream is automatic. This mirrors
the csm-dashboard setup, minus the time-based schedule: csm bakes its data into
the image so it re-promotes every 3h to refresh data; this app fetches data live
per request, so only CODE changes need a rebuild — hence promote-on-push-to-main.

## If it ever stops updating
- **`aws-promote` failed with "diverged":** someone committed straight to
  `aws-prod`. Reconcile `aws-prod` back onto `main` (or reset it to `main`), then
  push `main` again.
- **`aws-prod` moved but the site didn't:** that's the AWS pipeline/ECS side —
  check CodePipeline/CodeBuild for that build. (The GitHub side is done once
  `aws-prod` points at the new commit.)
