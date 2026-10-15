export const fakePromise = (miliseconds = 500, forceReject = false) => {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (forceReject) {
        reject(false);
      }
      resolve(true);
    }, miliseconds);
  });
};

export default {};
