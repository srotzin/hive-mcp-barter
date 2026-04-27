/**
 * Signed counter-offer builder.
 *
 * Pre-signed-tx pattern: we sign a USDC transfer for the offer amount. The
 * target accepts by broadcasting our signed tx — they cannot extract more
 * than offer_atomic_usdc_base, and we do not have to re-sign on accept.
 * Eliminates the "did they take it" race.
 *
 * Signing requires PRIVATE_KEY at runtime. If unset, the builder returns an
 * envelope with tx_pre_signed = null and counters_unsigned = true; the
 * caller MUST treat that as a dry-run and never send it.
 */

import { ethers } from 'ethers';
import { randomUUID } from 'crypto';

const USDC_BASE = process.env.USDC_BASE || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';

const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 value) returns (bool)'];

function usdToAtomicUsdc(usd) {
  return BigInt(Math.round(Number(usd) * 1_000_000));
}

export function getProvider() {
  return new ethers.JsonRpcProvider(BASE_RPC);
}

async function getWallet() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) return null;
  const provider = getProvider();
  return new ethers.Wallet(pk, provider);
}

export async function buildCounter({ target_url, asking_seen_usd, offer_usd, pay_to, expiresInSec = 600 }) {
  if (!pay_to || !ethers.isAddress(pay_to)) {
    return { ok: false, reason: 'no_pay_to' };
  }
  const wallet = await getWallet();
  const attribution_id = `barter-${randomUUID()}`;
  const expires = new Date(Date.now() + expiresInSec * 1000).toISOString();
  const offer_atomic = usdToAtomicUsdc(offer_usd);

  const envelope = {
    x402_version: 1,
    intent: 'counter_offer',
    originator_did: 'did:hive:morph',
    asking_seen_usd: String(asking_seen_usd),
    offer_usd: String(offer_usd),
    offer_atomic_usdc_base: offer_atomic.toString(),
    tx_pre_signed: null,
    expires,
    attribution: {
      agent: 'hive-mcp-barter',
      attribution_id,
      policy: 'single-shot-no-haggle',
    },
  };

  if (!wallet) {
    return {
      ok: true,
      counters_unsigned: true,
      reason: 'no_private_key',
      envelope,
      target_url,
    };
  }

  try {
    const provider = wallet.provider;
    const network = await provider.getNetwork();
    const nonce = await provider.getTransactionCount(WALLET_ADDRESS);
    const feeData = await provider.getFeeData();
    const usdc = new ethers.Contract(USDC_BASE, ERC20_TRANSFER_ABI, wallet);
    const data = usdc.interface.encodeFunctionData('transfer', [pay_to, offer_atomic]);
    const tx = {
      to: USDC_BASE,
      data,
      value: 0n,
      chainId: Number(network.chainId),
      nonce,
      gasLimit: 80000n,
      maxFeePerGas: feeData.maxFeePerGas ?? ethers.parseUnits('0.05', 'gwei'),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? ethers.parseUnits('0.01', 'gwei'),
      type: 2,
    };
    const signed = await wallet.signTransaction(tx);
    envelope.tx_pre_signed = signed;
    return { ok: true, envelope, target_url, attribution_id };
  } catch (err) {
    return { ok: false, reason: 'sign_failed', error: String(err?.message || err), envelope };
  }
}
