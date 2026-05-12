console.log("worker running");

// on loop hit backend /worker endpoint

postMessage({ type: "ready" });
