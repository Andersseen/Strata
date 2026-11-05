import { defineEventHandler } from "h3";

import { scaleRead } from "../../../../scale/native";

export default defineEventHandler((event) => scaleRead("r4", event));
