// Shared API error codes. User-facing API errors return a stable `code` alongside a plain-English
// `error` (fallback). The client maps the code to a localized message via apiErrorMessage(), so a
// non-English user gets a translated message instead of the raw English string.
//
// Only errors a normal user can trigger through the UI carry a code. Purely defensive / malformed-
// request errors ("bad request", "expected multipart form-data", etc.) keep a plain string, since a
// real user never sees them.

import { NextResponse } from "next/server";

export type ApiErrorCode =
  // generic
  | "NOT_AUTHENTICATED"
  | "NOT_A_MEMBER"
  | "MEMBERSHIP_UNVERIFIED"
  | "CASE_NOT_FOUND"
  // content validation
  | "GROUNDS_LENGTH"
  | "DEFENSE_LENGTH"
  | "REPLY_LENGTH"
  | "INAPPROPRIATE_LANGUAGE"
  | "COMMENT_INVALID"
  // state gates
  | "VOTING_LOCKED_GROUNDS"
  | "VOTING_LOCKED_RESPONSE"
  | "VOTING_LOCKED_REPLY"
  | "VOTING_NOT_OPEN"
  | "FLAG_ALREADY_OPENED"
  // authorship / ownership
  | "NOT_PROVIDER"
  | "NOT_YOUR_FLAG"
  | "NOT_CO_INITIATOR"
  | "CANNOT_REPLY_YET"
  | "CANNOT_ADD_GROUNDS_YET"
  | "PROVIDER_NEEDS_RESPONSE"
  // listing
  | "LOGO_REQUIRED"
  | "NOT_REGISTERED"
  | "NAME_TAKEN"
  | "ADDRESS_OTHER_LISTING"
  | "ADDRESS_NOT_ON_LISTING";

// The map from code to the i18n key the client should render. Kept here so server and client agree.
export const API_ERROR_I18N: Record<ApiErrorCode, string> = {
  NOT_AUTHENTICATED: "apiErr.notAuthenticated",
  NOT_A_MEMBER: "apiErr.notAMember",
  MEMBERSHIP_UNVERIFIED: "apiErr.membershipUnverified",
  CASE_NOT_FOUND: "apiErr.caseNotFound",
  GROUNDS_LENGTH: "apiErr.groundsLength",
  DEFENSE_LENGTH: "apiErr.defenseLength",
  REPLY_LENGTH: "apiErr.replyLength",
  INAPPROPRIATE_LANGUAGE: "apiErr.inappropriate",
  COMMENT_INVALID: "apiErr.commentInvalid",
  VOTING_LOCKED_GROUNDS: "apiErr.votingLockedGrounds",
  VOTING_LOCKED_RESPONSE: "apiErr.votingLockedResponse",
  VOTING_LOCKED_REPLY: "apiErr.votingLockedReply",
  VOTING_NOT_OPEN: "apiErr.votingNotOpen",
  FLAG_ALREADY_OPENED: "apiErr.flagAlreadyOpened",
  NOT_PROVIDER: "apiErr.notProvider",
  NOT_YOUR_FLAG: "apiErr.notYourFlag",
  NOT_CO_INITIATOR: "apiErr.notCoInitiator",
  CANNOT_REPLY_YET: "apiErr.cannotReplyYet",
  CANNOT_ADD_GROUNDS_YET: "apiErr.cannotAddGroundsYet",
  PROVIDER_NEEDS_RESPONSE: "apiErr.providerNeedsResponse",
  LOGO_REQUIRED: "apiErr.logoRequired",
  NOT_REGISTERED: "apiErr.notRegistered",
  NAME_TAKEN: "apiErr.nameTaken",
  ADDRESS_OTHER_LISTING: "apiErr.addressOtherListing",
  ADDRESS_NOT_ON_LISTING: "apiErr.addressNotOnListing",
};

// Helper to build a coded error response: { error, code }, with the given HTTP status.
export function apiError(code: ApiErrorCode, error: string, status: number) {
  return NextResponse.json({ error, code }, { status });
}
