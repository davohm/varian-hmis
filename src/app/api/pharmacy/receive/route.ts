import { NextRequest } from "next/server";

import { receiveStock, type ReceiveStockInput } from "@/server/commands/pharmacy";

import { handlePharmacyCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handlePharmacyCommand<ReceiveStockInput, unknown>(
    request,
    "Invalid stock receipt",
    receiveStock,
  );
}
