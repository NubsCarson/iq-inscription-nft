import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { MPL_CORE } from "./config.ts";
import { currencyList, SOL_INFO } from "./currencies.ts";
import { withConnection } from "./rpcpool.ts";

const TENSOR = new PublicKey("TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp");
// Layout from Tensor Marketplace v1's generated ListState account codec.
const LIST_STATE = Buffer.from([78, 242, 89, 138, 161, 221, 176, 75]);
const approvedCurrency = new Map(currencyList().map(info => [info.mint, info]));

function decodeListing(data: Buffer, mint: PublicKey, bump: number) {
  if (data.length < 221 || !data.subarray(0, 8).equals(LIST_STATE) ||
      data[8] !== 1 || data[9] !== bump || !new PublicKey(data.subarray(42, 74)).equals(mint)) {
    throw new Error("Invalid Tensor listing account.");
  }
  const owner = new PublicKey(data.subarray(10, 42)).toBase58();
  const price = data.readBigUInt64LE(74);
  let offset = 82;
  const address = () => {
    if (offset + 32 > data.length) throw new Error("Incomplete Tensor account address.");
    const key = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return key;
  };
  const optionalAddress = () => {
    const tag = data[offset++];
    if (tag === 0) return null;
    if (tag !== 1) throw new Error("Invalid Tensor account option.");
    return address().toBase58();
  };
  const currency = optionalAddress() ?? "SOL";
  const expiry = data.readBigInt64LE(offset);
  offset += 8;
  const privateTaker = optionalAddress();
  const makerBroker = optionalAddress();
  const rentPayer = address();
  const cosigner = address();
  if (price === 0n || expiry < 0n || offset + 64 > data.length) {
    throw new Error("Invalid Tensor listing terms.");
  }
  return {
    owner, price: price.toString(), currency, expiry,
    privateTaker, makerBroker,
    rentPayer: rentPayer.equals(PublicKey.default) ? null : rentPayer.toBase58(),
    cosigner: cosigner.equals(PublicKey.default) ? null : cosigner.toBase58(),
  };
}

// Use one confirmed read for the Core owner, canonical Tensor PDA and chain
// clock. Cached market rows have no reliable currency or current ownership.
export async function readCoreTensorMarket(mintAddress: string) {
  const mint = new PublicKey(mintAddress);
  const [order, bump] = PublicKey.findProgramAddressSync([Buffer.from("list_state"), mint.toBuffer()], TENSOR);
  const [core, account, clock] = await withConnection(rpc =>
    rpc.getMultipleAccountsInfo([mint, order, SYSVAR_CLOCK_PUBKEY], "confirmed"));
  if (!core?.owner.equals(MPL_CORE) || core.data.length < 66 ||
      core.data[0] !== 1 || core.data[33] !== 2) {
    throw new Error("Expected a collection-bound Metaplex Core asset.");
  }
  const currentOwner = new PublicKey(core.data.subarray(1, 33)).toBase58();
  if (!account) return { currentOwner, listing: null };
  if (!account.owner.equals(TENSOR) || !clock || clock.data.length < 40) {
    throw new Error("The Tensor listing could not be verified.");
  }
  const { expiry, ...terms } = decodeListing(account.data, mint, bump);
  const expired = expiry < clock.data.readBigInt64LE(32);
  const orderAddress = order.toBase58();
  const { currency, privateTaker, cosigner } = terms;
  return {
    currentOwner,
    listing: {
      ...terms, order: orderAddress, mint: mint.toBase58(), expiry: expiry.toString(), expired,
      currencyInfo: currency === "SOL" ? SOL_INFO : approvedCurrency.get(currency) ?? null,
      buySupported: !expired && currentOwner === orderAddress && currency === "SOL" && !privateTaker && !cosigner,
    }
  };
}
