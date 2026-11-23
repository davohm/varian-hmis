DROP INDEX "claims_facility_sha_ref_idx";--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "supersedes_claim_id" uuid;--> statement-breakpoint
CREATE INDEX "claims_facility_sha_ref_idx" ON "claims" USING btree ("facility_id","sha_claim_ref");