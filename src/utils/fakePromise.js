export const fakePromise = (miliseconds = 0) => {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, miliseconds);
  });
};

export default {};
