const btn = document.getElementById("actionBtn");
if (btn) {
  btn.addEventListener("click", () => {
    btn.textContent = "Clicked";
  });
}
