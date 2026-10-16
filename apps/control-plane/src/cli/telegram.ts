import { pathToFileURL } from "node:url";
import { runTelegramAdmin } from "../telegram/admin.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTelegramAdmin(process.argv[2], process.env)
    .then((out) => console.log(out))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
