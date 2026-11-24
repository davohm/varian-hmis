export type PatientPayerType = "cash" | "sha" | "insurance";

export interface SearchResult {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  otherNames: string | null;
  phone: string | null;
  dob: string | null;
  sex: string;
  nationalId?: string | null;
  payerType?: PatientPayerType | null;
  createdAt?: string;
}
