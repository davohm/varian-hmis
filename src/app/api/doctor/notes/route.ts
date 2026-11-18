import { NextRequest } from "next/server";

import { saveClinicalNote, type SaveClinicalNoteInput } from "@/server/commands/clinical";

import { handleDoctorCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handleDoctorCommand<SaveClinicalNoteInput, unknown>(
    request,
    "Invalid clinical note",
    saveClinicalNote,
  );
}
