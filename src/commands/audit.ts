import { Command } from 'commander';
import * as dotenv from 'dotenv';
import { AuditLogger } from '../audit/AuditLogger';
import { createAuditSigner } from '../audit/signing/factory';

// Load env for key/provider configuration
dotenv.config();

/**
 * Audit command that supports software (Ed25519), PKCS#11, and AWS KMS signing.
 *
 * Provider selection:
 *   --hsm-provider software   (default) local Ed25519 PKCS#8 PEM key
 *   --hsm-provider pkcs11     PKCS#11 HSM via pkcs11js (see PKCS#11 env vars)
 *   --hsm-provider kms        AWS KMS asymmetric key (see KMS env vars)
 *
 * KMS env vars:
 *   ERST_KMS_KEY_ID             KMS key ID or ARN
 *   AWS_REGION                  AWS region
 *   ERST_KMS_SIGNING_ALGORITHM  KMS algorithm (default: ECDSA_SHA_256)
 */
export function registerAuditCommands(program: Command): void {
  program
    .command('audit:sign')
    .description('Generate a signed audit log from a JSON payload')
    .requiredOption('--payload <json>', 'JSON string to sign as the audit trace')
    .option(
      '--hsm-provider <provider>',
      'Signing provider: software (default), pkcs11, or kms'
    )
    .option(
      '--software-private-key <pem>',
      'Ed25519 private key (PKCS#8 PEM). If unset, uses ERST_AUDIT_PRIVATE_KEY_PEM'
    )
    .option(
      '--kms-key-id <id>',
      'AWS KMS key ID or ARN. If unset, uses ERST_KMS_KEY_ID'
    )
    .option(
      '--kms-signing-algorithm <alg>',
      'AWS KMS signing algorithm (default: ECDSA_SHA_256). If unset, uses ERST_KMS_SIGNING_ALGORITHM'
    )
    .action(async (opts: any) => {
      try {
        const trace = JSON.parse(opts.payload);

        const signer = createAuditSigner({
          hsmProvider: opts.hsmProvider,
          softwarePrivateKeyPem: opts.softwarePrivateKey ?? process.env.ERST_AUDIT_PRIVATE_KEY_PEM,
          kmsKeyId: opts.kmsKeyId,
          kmsSigningAlgorithm: opts.kmsSigningAlgorithm,
        });

        const providerLabel = opts.hsmProvider ?? 'software';
        const logger = new AuditLogger(signer, providerLabel);
        const log = await logger.generateLog(trace);

        // Print to stdout so callers can redirect to a file
        process.stdout.write(JSON.stringify(log, null, 2) + '\n');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[FAIL] audit signing failed: ${msg}`);
        process.exit(1);
      }
    });
}
