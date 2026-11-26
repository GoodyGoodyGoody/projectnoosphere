// Shared by a revision's expected result and a report's actual observation.
const BARE_SUCCESS =
  /^(?:(?:exit(?:ed)?|return(?:ed)?|rc|status|code)(?: with)?(?: (?:code|status))?\s*[:=]?\s*0|0|ok|okay|success(?:ful)?|succeeded|pass(?:ed)?|done|works|worked|it worked|fine|no errors?)$/i;
export function isBareSuccess(observed: string): boolean {
  return BARE_SUCCESS.test(observed.trim().replace(/^["'`]+|["'`.!\s]+$/g, ""));
}
