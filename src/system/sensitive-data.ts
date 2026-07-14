export function isSensitivePathLike(value: unknown): boolean {
  const path = String(value ?? "").toLowerCase();
  return /(^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|\.gnupg|\.aws|\.kube|keychains?|credentials?|secrets?)([/\\]|$)|\.(?:pem|key|p12|pfx)$/.test(path);
}

export function isSecretEnvironmentKey(key: string): boolean {
  return /(?:^|_)(?:API_?KEY|ACCESS_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|COOKIE|PRIVATE_?KEY|CLIENT_?SECRET)(?:_|$)/i.test(key);
}
