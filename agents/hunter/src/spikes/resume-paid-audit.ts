import { closeProcessPostgresStores } from '@rebel/shared';
import { hunterConfig } from '../config.js';
import { recoverPaidAudit } from '../paid-audit-recovery.js';
import { browserAuthorityContext } from '../integrations/altana/browser-context.js';
import { loadActiveAltanaAuthority } from '../integrations/altana/authority.js';

async function main() {
  if (process.env.HUNTER_RESUME_CONFIRM !== 'I_UNDERSTAND_VERIFIER_PAYMENT') throw new Error('Verifier payment confirmation required');
  const missionId = process.env.HUNTER_RESUME_MISSION_ID;
  if (!missionId) throw new Error('HUNTER_RESUME_MISSION_ID required');
  const authorityId = process.env.HUNTER_RESUME_AUTHORITY_ID;
  if (!authorityId) return recoverPaidAudit(missionId);
  const record = await loadActiveAltanaAuthority({authorityId, storePath: hunterConfig.altana.sessionStorePath,
    evidencePath: hunterConfig.altana.authorityEvidencePath, encryptionKey: hunterConfig.altana.sessionEncryptionKey!});
  return browserAuthorityContext.run({authorityId, walletAddress: record.authority.walletAddress}, () => recoverPaidAudit(missionId));
}
main().catch(() => { console.error('Paid audit recovery failed; inspect original mission status.'); process.exitCode = 1; })
  .finally(() => closeProcessPostgresStores().catch(() => undefined));
