import { randomBytes } from "node:crypto";
export const AUDIT_ID_RE = /^aud_[0-9a-f]{16}$/;
export const newAuditId = (): string => "aud_" + randomBytes(8).toString("hex");
export const EVIDENCE_ID_RE = /^ev_[0-9a-f]{12}$/;
