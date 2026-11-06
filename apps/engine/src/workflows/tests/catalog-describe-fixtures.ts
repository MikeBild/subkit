export function result(object: unknown) {
  return {
    object,
    text: JSON.stringify(object),
    model_used: "test-model",
    fell_back: false,
    route: {} as never,
    assembled: {} as never,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
  };
}
