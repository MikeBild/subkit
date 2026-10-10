export function selectFunctionalJourneys(journeys, args, environment) {
  if (environment.COCKPIT_FUNCTIONAL_JOURNEYS !== undefined)
    throw new Error(
      "COCKPIT_FUNCTIONAL_JOURNEYS is not allowed; official verification always runs all journeys. Use explicit --journey arguments only for targeted iteration.",
    );
  const requested = [];
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "--journey" || !args[index + 1])
      throw new Error("Expected --journey <name>");
    requested.push(args[index + 1]);
  }
  if (requested.some((name) => !journeys.some(([known]) => known === name)))
    throw new Error("Unknown cockpit functional journey");
  return {
    selected: journeys.filter(([name]) => requested.length === 0 || requested.includes(name)),
    partial: requested.length > 0,
  };
}
