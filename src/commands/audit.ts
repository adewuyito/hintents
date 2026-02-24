import { Command } from 'commander';
import * as dotenv from 'dotenv';
import { AuditLogger } from '../audit/AuditLogger';
import { renderAuditHTML, writeAuditReport } from '../audit/AuditRenderer';
import { createAuditSigner } from '../audit/signing/factory';

// Load env for key/provider configuration
dotenv.config();

/**
 * Minimal audit command to demonstrate signer selection, including HSM/PKCS#11.
 *
 * This does not change the audit log format beyond including signature/publicKey metadata.
 */
export function registerAuditCommands(program: Command): void {
  program
    .command('audit:sign')
    .description('Generate a signed audit log from a JSON payload (demo/test utility)')
    .requiredOption('--payload <json>', 'JSON string to sign as the audit trace')
    .option('--hsm-provider <provider>', 'HSM provider to use (pkcs11). Defaults to software signing')
    .option(
      '--software-private-key <pem>',
      'Ed25519 private key (PKCS#8 PEM). If unset, uses ERST_AUDIT_PRIVATE_KEY_PEM'
    )
    .action(async (opts: any) => {
      try {
        const trace = JSON.parse(opts.payload);

        const signer = createAuditSigner({
          hsmProvider: opts.hsmProvider,
          softwarePrivateKeyPem: opts.softwarePrivateKey ?? process.env.ERST_AUDIT_PRIVATE_KEY_PEM,
        });

        const logger = new AuditLogger(signer, opts.hsmProvider ?? 'software');
        const log = await logger.generateLog(trace);

        // Print to stdout so callers can redirect to a file
        process.stdout.write(JSON.stringify(log, null, 2) + '\n');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[FAIL] audit signing failed: ${msg}`);
        process.exit(1);
      }
    });

  program
    .command('audit:render')
    .description('Render a raw ExecutionTrace or SignedAuditLog JSON payload to an HTML report')
    .requiredOption('--payload <json>', 'JSON string containing the audit payload (ExecutionTrace or SignedAuditLog)')
    .option('--output <path>', 'Write HTML to this file instead of stdout')
    .option('--title <title>', 'Report title (default: "Audit Report")')
    .action((opts: any) => {
      try {
        const payload = JSON.parse(opts.payload);

        if (opts.output) {
          writeAuditReport(payload, opts.output, opts.title);
          console.error(`[OK] Audit report written to ${opts.output}`);
        } else {
          process.stdout.write(renderAuditHTML(payload, opts.title));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[FAIL] audit render failed: ${msg}`);
        process.exit(1);
      }
    });
}
