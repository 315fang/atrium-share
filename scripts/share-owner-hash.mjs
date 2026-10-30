import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";

// Only the publisher's Access Key ID is needed; never enter its secret key here.
const prompt = createInterface({ input: process.stdin, output: process.stderr });
try {
  const accessKeyId = (await prompt.question("Publisher login Access Key ID: ")).trim();
  if (!accessKeyId) throw new Error("The publisher Access Key ID must not be empty.");
  process.stdout.write(createHash("sha256").update(accessKeyId).digest("hex") + "\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : "Cannot hash the key ID.") + "\n");
  process.exitCode = 1;
} finally {
  prompt.close();
}
