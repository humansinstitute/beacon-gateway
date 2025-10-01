// cvm_client.ts
// A standalone script to test the Identity CVM server.

import { Client } from "@modelcontextprotocol/sdk/client";
import { ApplesauceRelayPool, NostrClientTransport, PrivateKeySigner } from "@contextvm/sdk";
import { getEnv } from "./src/types";

// --- Configuration ---
// This is the PUBLIC key of your running Identity CVM server.
// The server logs this on startup.
const SERVER_PUBKEY = "2e7e636738142c8641848674b9102401e0f40dd3f885504fda2dcbbc00f6acf4"; // <--- REPLACE WITH YOUR SERVER'S PUBKEY

// This is a temporary client private key. Can be anything.
const CLIENT_PRIVATE_KEY_HEX = "66a628380b51d3362734b5e1a36d388049411b021e42a401437034384248a32d";
const RELAYS = ["wss://relay.contextvm.org", "wss://cvm.otherstuff.ai"];

// This is the npub of the user you mapped in the database.
// The test will fail if this user doesn't exist in your `local_npub_map` table.
const USER_NPUB = "npub1hs7h7pfsdeqxmhkk9vmutuqs0vztv503c4ve6wlq3nn2a58w6cfss9sus3"; // <--- REPLACE WITH A MAPPED USER NPUB

async function main() {
  console.log("Initializing CVM client...");
  const signer = new PrivateKeySigner(CLIENT_PRIVATE_KEY_HEX);
  const relayPool = new ApplesauceRelayPool(RELAYS);

  const clientTransport = new NostrClientTransport({
    signer,
    relayHandler: relayPool,
    serverPubkey: SERVER_PUBKEY,
  });

  const mcpClient = new Client({
    name: "test-cvm-client",
    version: "1.0.0",
  });

  console.log("Connecting to Identity CVM server...");
  await mcpClient.connect(clientTransport);
  console.log("Connected!");

  console.log('\nCalling the "payLnAddress" tool...');
  const result = await mcpClient.callTool({
    name: "payLnAddress",
    arguments: {
      npub: USER_NPUB,
      refId: "test-" + Date.now(),
      lnAddress: "testLNAddress",
      amount: 5000,
      responsePubkey: "a_mock_brain_pubkey", // This would be the Brain's CVM pubkey
      responseTool: "confirmPayment",
    },
  });

  console.log("Tool call result:", result);

  await mcpClient.close();
  console.log("\nConnection closed.");
}

main().catch((error) => {
  console.error("Client failed:", error);
  process.exit(1);
});
