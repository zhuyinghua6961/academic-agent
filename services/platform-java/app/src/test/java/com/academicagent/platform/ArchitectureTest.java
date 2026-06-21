package com.academicagent.platform;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

@AnalyzeClasses(packages = "com.academicagent.platform")
public class ArchitectureTest {

    @ArchTest
    static final ArchRule controllers_live_in_app =
            classes().that().areAnnotatedWith(org.springframework.web.bind.annotation.RestController.class)
                    .should()
                    .resideInAnyPackage("..api..", "..api.internal..")
                    .allowEmptyShould(true);

    @ArchTest
    static final ArchRule identity_does_not_depend_on_app = noClasses()
            .that()
            .resideInAPackage("com.academicagent.platform.identity..")
            .should()
            .dependOnClassesThat()
            .resideInAPackage("com.academicagent.platform.api..");

    @ArchTest
    static final ArchRule research_does_not_depend_on_app = noClasses()
            .that()
            .resideInAPackage("com.academicagent.platform.research..")
            .should()
            .dependOnClassesThat()
            .resideInAPackage("com.academicagent.platform.api..");

    @ArchTest
    static final ArchRule sse_does_not_depend_on_app = noClasses()
            .that()
            .resideInAPackage("com.academicagent.platform.sse..")
            .should()
            .dependOnClassesThat()
            .resideInAPackage("com.academicagent.platform.api..");
}
