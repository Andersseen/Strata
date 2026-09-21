import { bootstrapApplication } from "@angular/platform-browser";

import { App } from "./app/app";
import { appConfig } from "./app/app.config";
import "./styles.css";

void bootstrapApplication(App, appConfig);
