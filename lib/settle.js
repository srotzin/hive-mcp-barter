/**
 * Settlement step.
 *
 * The target broadcasts our pre-signed tx; settle() polls the Base RPC for
 * the transaction receipt by hash. If the target instead returns a hash they
 * already broadcast, we accept that as the receipt of record.
 */

import { ethers } from 'ethers';
import { getProvider } from './counter.js';

export async function awaitReceipt(tx_hash, timeoutMs = 60000) {
  if (!tx_hash || !/^0x[0-9a-f]{64}$/i.test(tx_hash)) {
    return { ok: false, reason: 'invalid_hash' };
  }
  const provider = getProvider();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const receipt = await provider.getTransactionReceipt(tx_hash);
      if (receipt) {
        return {
          ok: true,
          tx_hash,
          status: receipt.status,
          block_number: receipt.blockNumber,
          gas_used: receipt.gasUsed?.toString?.() ?? null,
        };
      }
    } catch {
      // ignore and retry
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  return { ok: false, reason: 'timeout', tx_hash };
}

export function expectedTxHash(signed_tx) {
  try {
    const parsed = ethers.Transaction.from(signed_tx);
    return parsed.hash;
  } catch {
    return null;
  }
}
