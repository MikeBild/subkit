-- Add `aws_sigv4` to the credential_mode enum so connectors can store
-- AWS access keys for generic SigV4-signed requests (AppSync IAM,
-- DynamoDB, API Gateway IAM, every-other-AWS-service that doesn't
-- have a first-class subkit driver).
--
-- The signing happens at dispatch time (`signSigV4Request` in
-- `connectors/drivers/aws-sigv4.ts`) using the credential's
-- `access_key_id` + `secret_access_key` + optional `session_token`,
-- plus `aws_region` + `aws_service` from the connector config.

ALTER TYPE credential_mode ADD VALUE IF NOT EXISTS 'aws_sigv4';
