import styles from "./marketing.module.css";
import { ProductMock } from "./ProductMock";

export function ProductTour() {
  return (
    <section className={styles.section} aria-labelledby="app-h">
      <h2 id="app-h">What using it looks like</h2>
      <p className={styles.lede}>
        This one is a harness: Tandem against plain Claude Code. The same four screens work for any
        kind of project. You type a question and press two buttons, and agents do the rest. Pick a
        step to see its screen.
      </p>
      <ProductMock />
    </section>
  );
}
