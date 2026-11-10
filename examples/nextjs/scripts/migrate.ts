import { getMigrations } from "better-auth/db/migration";
import { auth, database } from "../lib/auth";

try {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  console.info("Better Auth database migrated.");
} finally {
  database.close();
}
