import { Keypair } from '@stellar/stellar-sdk';

const keypair = Keypair.random();
const friendbot = new URL('https://friendbot.stellar.org');
friendbot.searchParams.set('addr', keypair.publicKey());

const response = await fetch(friendbot);
if (!response.ok) {
  throw new Error(`Friendbot failed (${response.status}): ${await response.text()}`);
}

process.stdout.write([
  'Created and funded a TESTNET-ONLY facilitator account.',
  'Store the secret in a secret manager; never commit it or send it to a buyer.',
  `FACILITATOR_STELLAR_PRIVATE_KEY=${keypair.secret()}`,
  `FACILITATOR_STELLAR_PUBLIC_KEY=${keypair.publicKey()}`,
  '',
].join('\n'));
