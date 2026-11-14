import { beforeAll } from "vitest";
import { installOriginStub } from "./origin";

beforeAll(() => {
	installOriginStub();
});
