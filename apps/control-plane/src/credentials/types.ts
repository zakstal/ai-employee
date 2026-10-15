import type { CredentialSpec, Employee, Role } from "@ai-employee/core";
import type { Config } from "../config.js";

/** Where `secret:` references are read from. undefined = no such secret / no version. */
export interface SecretStore {
  get(name: string): Promise<string | undefined>;
}

export interface CredentialContext {
  employee: Employee;
  role: Role;
  taskId: string;
  config: Config;
  secrets: SecretStore;
  fetch: typeof fetch;
  now: () => Date;
}

export interface ResolvedCredential {
  env: Record<string, string>;
  expiresAt?: Date;
}

export interface CredentialProvider<S extends CredentialSpec = CredentialSpec> {
  readonly kind: S["kind"];
  /** Static, no network. Problems for `config check`. */
  validate(name: string, spec: S): string[];
  /** Env var NAMES this login sets. No network, no secrets: used for MCP placeholder checks, `config resolve`, conflict checks. */
  envNames(spec: S): string[];
  /** Per task. May use the network. Never logs values. */
  resolve(name: string, spec: S, ctx: CredentialContext): Promise<ResolvedCredential>;
}
