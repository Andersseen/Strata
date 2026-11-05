import { defineEventHandler } from "h3";

import { scaleCreate } from "../../../../scale/native";

export default defineEventHandler((event) => scaleCreate("r5", event));
