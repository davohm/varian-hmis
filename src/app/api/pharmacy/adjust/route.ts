import { NextRequest } from "next/server";

import { adjustStock, type AdjustStockInput } from "@/server/commands/pharmacy";

import { handlePharmacyCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handlePharmacyCommand<AdjustStockInput, unknown>(
    request,
    "Invalid stock adjustment",
    adjustStock,
  );
}
