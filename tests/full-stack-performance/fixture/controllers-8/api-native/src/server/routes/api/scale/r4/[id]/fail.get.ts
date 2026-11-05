import { defineEventHandler } from "h3";

import { scaleFail } from "../../../../../scale/native";

export default defineEventHandler(() => scaleFail("r4"));
