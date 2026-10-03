import { runSandboxContractTests } from "./contract.js";
import { createFakeSandboxProvider } from "./fake.js";

runSandboxContractTests((script) => createFakeSandboxProvider(script));
