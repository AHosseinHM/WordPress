<?php
/**
 * Plugin Name: تخفیف یک‌کلیکی ووکامرس
 * Description: اعمال یا حذف تخفیف روی همه محصولات یا دسته‌بندی‌های خاص با یک کلیک.
 * Version: 1.0.0
 * Requires Plugins: woocommerce
 * Text Domain: one-click-discount
 */
if ( ! defined( 'ABSPATH' ) ) exit;

class OCD_Plugin {
	const META = '_ocd_applied';

	public function __construct() {
		add_action( 'admin_menu', [ $this, 'menu' ] );
		add_action( 'admin_post_ocd_apply', [ $this, 'handle_apply' ] );
		add_action( 'admin_post_ocd_remove', [ $this, 'handle_remove' ] );
	}

	public function menu() {
		add_submenu_page( 'woocommerce', 'تخفیف یک‌کلیکی', 'تخفیف یک‌کلیکی', 'manage_woocommerce', 'one-click-discount', [ $this, 'page' ] );
	}

	public function page() {
		if ( ! class_exists( 'WooCommerce' ) ) { echo '<div class="notice notice-error"><p>ووکامرس فعال نیست.</p></div>'; return; }
		$cats = get_terms( [ 'taxonomy' => 'product_cat', 'hide_empty' => false ] );
		if ( isset( $_GET['ocd_done'] ) ) {
			printf( '<div class="notice notice-success"><p>%s</p></div>', esc_html( sprintf( '%d محصول به‌روزرسانی شد.', (int) $_GET['ocd_done'] ) ) );
		}
		?>
		<div class="wrap" dir="rtl">
			<h1>تخفیف یک‌کلیکی</h1>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="ocd_apply">
				<?php wp_nonce_field( 'ocd' ); ?>
				<table class="form-table">
					<tr><th>محدوده</th><td>
						<label><input type="radio" name="scope" value="all" checked> همه محصولات</label><br>
						<label><input type="radio" name="scope" value="cats"> فقط دسته‌بندی‌های انتخابی</label><br>
						<select name="cats[]" multiple size="8" style="min-width:300px;margin-top:6px">
							<?php foreach ( $cats as $c ) printf( '<option value="%d">%s</option>', $c->term_id, esc_html( $c->name ) ); ?>
						</select>
						<p class="description">برای انتخاب چند مورد Ctrl را نگه دارید.</p>
					</td></tr>
					<tr><th>نوع تخفیف</th><td>
						<select name="type"><option value="percent">درصدی</option><option value="fixed">مبلغ ثابت</option></select>
					</td></tr>
					<tr><th>مقدار</th><td><input type="number" name="value" step="any" min="0" required></td></tr>
					<tr><th>شروع (اختیاری)</th><td><input type="date" name="from"></td></tr>
					<tr><th>پایان (اختیاری)</th><td><input type="date" name="to"></td></tr>
				</table>
				<?php submit_button( 'اعمال تخفیف', 'primary', 'submit', false, [ 'onclick' => "return confirm('تخفیف اعمال شود؟');" ] ); ?>
			</form>
			<hr>
			<h2>حذف تخفیف</h2>
			<p>فقط تخفیف‌هایی که با این افزونه اعمال شده‌اند حذف می‌شوند. (محدوده بالا اعمال می‌شود)</p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="ocd_remove">
				<?php wp_nonce_field( 'ocd' ); ?>
				<label><input type="radio" name="scope" value="all" checked> همه</label>
				<label><input type="radio" name="scope" value="cats"> دسته‌بندی‌های انتخابی:</label>
				<select name="cats[]" multiple size="5">
					<?php foreach ( $cats as $c ) printf( '<option value="%d">%s</option>', $c->term_id, esc_html( $c->name ) ); ?>
				</select>
				<?php submit_button( 'حذف تخفیف‌ها', 'secondary', 'submit', false, [ 'onclick' => "return confirm('تخفیف‌ها حذف شوند؟');" ] ); ?>
			</form>
		</div>
		<?php
	}

	private function get_ids() {
		$args = [ 'limit' => -1, 'return' => 'ids', 'status' => [ 'publish', 'private', 'draft' ] ];
		if ( ( $_POST['scope'] ?? 'all' ) === 'cats' ) {
			$term_ids = array_map( 'intval', (array) ( $_POST['cats'] ?? [] ) );
			$slugs = [];
			foreach ( $term_ids as $id ) { $t = get_term( $id, 'product_cat' ); if ( $t && ! is_wp_error( $t ) ) $slugs[] = $t->slug; }
			if ( ! $slugs ) return [];
			$args['category'] = $slugs;
		}
		return wc_get_products( $args );
	}

	private function guard() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) wp_die( 'دسترسی ندارید.' );
		check_admin_referer( 'ocd' );
	}

	private function done( $n ) {
		wp_safe_redirect( add_query_arg( [ 'page' => 'one-click-discount', 'ocd_done' => $n ], admin_url( 'admin.php' ) ) );
		exit;
	}

	private function calc( $regular, $type, $value ) {
		$regular = (float) $regular;
		if ( $regular <= 0 ) return '';
		$sale = $type === 'percent' ? $regular * ( 1 - min( $value, 100 ) / 100 ) : $regular - $value;
		if ( $sale <= 0 ) return '';
		return wc_format_decimal( round( $sale, wc_get_price_decimals() ) );
	}

	public function handle_apply() {
		$this->guard();
		$type  = ( $_POST['type'] ?? '' ) === 'fixed' ? 'fixed' : 'percent';
		$value = (float) ( $_POST['value'] ?? 0 );
		if ( $value <= 0 ) wp_die( 'مقدار تخفیف نامعتبر است.' );
		$from = sanitize_text_field( $_POST['from'] ?? '' );
		$to   = sanitize_text_field( $_POST['to'] ?? '' );
		@set_time_limit( 0 );

		$count = 0;
		foreach ( $this->get_ids() as $id ) {
			$p = wc_get_product( $id );
			if ( ! $p ) continue;
			$targets = $p->is_type( 'variable' ) ? array_filter( array_map( 'wc_get_product', $p->get_children() ) ) : [ $p ];
			foreach ( $targets as $t ) {
				$sale = $this->calc( $t->get_regular_price(), $type, $value );
				if ( $sale === '' ) continue;
				$t->set_sale_price( $sale );
				$t->set_date_on_sale_from( $from ?: null );
				$t->set_date_on_sale_to( $to ?: null );
				$t->update_meta_data( self::META, 1 );
				$t->save();
			}
			if ( $p->is_type( 'variable' ) ) WC_Product_Variable::sync( $id );
			$count++;
		}
		$this->done( $count );
	}

	public function handle_remove() {
		$this->guard();
		@set_time_limit( 0 );
		$count = 0;
		foreach ( $this->get_ids() as $id ) {
			$p = wc_get_product( $id );
			if ( ! $p ) continue;
			$targets = $p->is_type( 'variable' ) ? array_filter( array_map( 'wc_get_product', $p->get_children() ) ) : [ $p ];
			foreach ( $targets as $t ) {
				if ( ! $t->get_meta( self::META ) ) continue;
				$t->set_sale_price( '' );
				$t->set_date_on_sale_from( null );
				$t->set_date_on_sale_to( null );
				$t->delete_meta_data( self::META );
				$t->save();
			}
			if ( $p->is_type( 'variable' ) ) WC_Product_Variable::sync( $id );
			$count++;
		}
		$this->done( $count );
	}
}
new OCD_Plugin();
