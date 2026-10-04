// Java encoding probe. ASCII-only source: every CJK char is written as a unicode escape,
// so it compiles on any machine with any -encoding. Shipped precompiled as Java 6 bytecode,
// so the intranet box only needs java.exe, not javac.
public class Say {
    public static void main(String[] args) {
        String s = "\u4e2d\u6587\u9519\u8bef\u4fe1\u606f\uff1a\u8fde\u63a5\u5931\u8d25\uff08\u8fbe\u68a6\uff09";
        System.out.println(s);
        System.err.println(s);
    }
}
