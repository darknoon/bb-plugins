// UNDEPLOYED prototype: candidate ordering alone is not authorization.
// Only selectVerifiedRead may be used at a real credential boundary.
// Read-only selection: never refresh, persist, or erase a credential.
function oauth(value) {
  const o=value?.claudeAiOauth;
  return o && typeof o.accessToken==='string' && o.accessToken.length>0 &&
    typeof o.refreshToken==='string' && o.refreshToken.length>0 &&
    Number.isFinite(o.expiresAt) && o.expiresAt>0 ? o : null;
}
function selectRead(primary, fallback) {
  const a=oauth(primary),b=oauth(fallback);
  // Missing/inaccessible Keychain is handled by native Claude, not this policy.
  if (!primary || typeof primary!=='object' || Array.isArray(primary) || !b)
    return {value:primary,selected:'keychain'};
  const p=primary.claudeAiOauth;
  const explicitlyCleared=p?.accessToken==='' && p?.refreshToken==='' && p?.expiresAt===0;
  // Do not turn an API-key-only/inference-only record into a different login.
  if (!a && !explicitlyCleared) return {value:primary,selected:'keychain'};
  if ((p.clientId??null)!==(b.clientId??null)) return {value:primary,selected:'keychain'};
  // An expiry orders normal rotations, not account identity or revocation.
  // Equal/unknown generations retain native preference; never guess a tie.
  if (a && b.expiresAt<=a.expiresAt)
    return {value:primary,selected:'keychain'};
  // Keep all Keychain connector/API-key fields; replace only the OAuth object.
  return {value:{...primary,claudeAiOauth:{...b}},selected:'file'};
}
async function selectVerifiedRead(primary,fallback,{expectedIdentity,verifyIdentity}={}) {
  const candidate=selectRead(primary,fallback);
  if (candidate.selected!=='file') return candidate;
  if (!expectedIdentity?.accountUuid || !expectedIdentity?.organizationUuid || typeof verifyIdentity!=='function')
    return {value:primary,selected:'keychain',refusal:'identity-unavailable'};
  try {
    // Verifier must use Anthropic's authenticated profile response, or a private
    // proof bound to this exact token; scopes/expiry/filename are not identity.
    const identity=await verifyIdentity(candidate.value.claudeAiOauth);
    if (identity?.accountUuid!==expectedIdentity.accountUuid || identity?.organizationUuid!==expectedIdentity.organizationUuid)
      return {value:primary,selected:'keychain',refusal:'identity-mismatch'};
    return candidate;
  } catch {
    return {value:primary,selected:'keychain',refusal:'identity-verification-failed'};
  }
}
module.exports={selectRead,selectVerifiedRead};
