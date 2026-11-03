/** Route on the tallied majority; the label is one of the step's `branches:`. */
export default async function route(input: { majority: unknown }) {
  return { branch: String(input.majority) };
}
