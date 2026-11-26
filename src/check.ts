// Shared by a revision's expected result and a report's actual observation.
const BARE_SUCCESS =
  /^(?:(?:exit(?:ed)?|return(?:ed)?|rc|status|code)(?:with)?(?:code|status)?0|0|ok|okay|success(?:ful)?|succeeded|pass(?:ed)?|done|works|worked|itworked|fine|noerrors?)$/;
export function isBareSuccess(observed: string): boolean {
  // Match migration 009's normalized phrases so a refusal is a useful API
  // 400 before SQLite's final guard. Formatting does not make success observable.
  const normalized = observed.toLowerCase().replace(/^["'`.!\s]+|["'`.!\s]+$/g, "").replace(/[\s:=]/g, "");
  return BARE_SUCCESS.test(normalized);
}
