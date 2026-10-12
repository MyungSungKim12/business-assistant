document$.subscribe(() => {
  document.querySelectorAll(".md-typeset img").forEach((image) => {
    if (image.closest("a") || image.dataset.zoomBound === "true") return;

    const sourceLabel = image.alt ? `${image.alt} 확대` : "화면 이미지 확대";
    image.dataset.zoomable = "true";
    image.dataset.zoomBound = "true";
    image.setAttribute("role", "button");
    image.setAttribute("tabindex", "0");
    image.setAttribute("aria-label", sourceLabel);

    const openLightbox = () => {
      const overlay = document.createElement("div");
      overlay.className = "ba-lightbox";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", `${image.alt || "화면 이미지"} 확대 보기`);

      const close = document.createElement("button");
      close.type = "button";
      close.className = "ba-lightbox__close";
      close.setAttribute("aria-label", "확대 이미지 닫기");
      close.textContent = "×";

      const enlarged = image.cloneNode(true);
      enlarged.removeAttribute("data-zoomable");
      enlarged.removeAttribute("data-zoom-bound");
      enlarged.removeAttribute("role");
      enlarged.removeAttribute("tabindex");
      enlarged.removeAttribute("aria-label");
      enlarged.addEventListener("click", (event) => event.stopPropagation());

      const dismiss = () => {
        overlay.remove();
        image.focus();
      };
      close.addEventListener("click", dismiss);
      overlay.addEventListener("click", dismiss);
      overlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") dismiss();
        if (event.key === "Tab") {
          event.preventDefault();
          close.focus();
        }
      });
      overlay.appendChild(close);
      overlay.appendChild(enlarged);
      document.body.appendChild(overlay);
      close.focus();
    };

    image.addEventListener("click", openLightbox);
    image.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openLightbox();
      }
    });
  });
});
