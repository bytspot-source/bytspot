terraform {
  backend "gcs" {
    bucket = "bytspot-bucket1"
    prefix = "terraform/state"
  }
}

