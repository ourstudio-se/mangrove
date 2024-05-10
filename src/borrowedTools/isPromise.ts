export function isPromise<T>(value: any): value is PromiseLike<T> {
  return value?.then != null;
}
