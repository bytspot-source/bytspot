# Bytspot Staging Setup (GCP us-east1)

These steps bootstrap the Atlanta beta infrastructure and CI/CD.

Prereqs
- gcloud CLI installed and authenticated to project articulate-bot-468815-n3
- Terraform >= 1.6 installed
- GitHub repo: bytspot-source/bytspot

## 1) Terraform apply (staging)
```
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform apply -var-file=environments/staging.tfvars
```
Outputs (copy to GitHub repo secrets):
- workload_identity_provider -> GCP_WORKLOAD_IDENTITY_PROVIDER
- deployer_service_account   -> GCP_DEPLOYER_SA
Also set:
- GCP_PROJECT_ID = articulate-bot-468815-n3

## 2) First pipeline run
- Merge to main (this commit)
- CI will build, scan, push to Artifact Registry (us-east1) and deploy bytspot-stg-api to Cloud Run
- Terraform also outputs cloud_run_api_url to verify the service

## 3) (Optional) Production infra
```
terraform -chdir=infra/terraform apply -var-file=environments/production.tfvars
```
Then use the manual GitHub workflow_dispatch to deploy to prod.

## Notes
## 4) Dashboard deployment
- CI also builds and deploys the dashboard service (bytspot-stg-dashboard)
- It automatically discovers the API Cloud Run URL and sets API_URL for SSE proxying
- Access the dashboard via the Cloud Run URL output or the console

- Images during bootstrap use Cloud Run hello container; replaced by CI once the first image is pushed
- Cloud SQL is private IP; Cloud Run connects through the Serverless VPC Connector
- Firestore/Redis are enabled by default; set enable_firestore/enable_memorystore to false if not needed yet

