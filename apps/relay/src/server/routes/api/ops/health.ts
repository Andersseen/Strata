import { defineEventHandler } from "h3";

export default defineEventHandler(() => ({
  status: "operational",
  source: "native-analog-route",
  checkedAt: new Date().toISOString(),
}));
