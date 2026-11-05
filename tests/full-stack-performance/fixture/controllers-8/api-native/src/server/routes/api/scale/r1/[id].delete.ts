import { defineEventHandler } from "h3";

import { scaleRemove } from "../../../../scale/native";

export default defineEventHandler((event) => scaleRemove("r1", event));
